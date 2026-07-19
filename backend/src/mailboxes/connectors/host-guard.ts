/*
 * SSRF guard for user-supplied mailbox hosts (defensive hardening for the
 * "Inbox Connectors & Provider Abstraction" connect flow).
 *
 * `POST /api/mailboxes` lets an authenticated caller name any `host`/`port`
 * for the server to open a TLS connection to. Without a guard that turns the
 * connect attempt into a blind internal port scanner / SSRF probe (loopback,
 * RFC1918, link-local incl. the 169.254.169.254 cloud-metadata endpoint,
 * ...). `assertHostAllowed` resolves the host and rejects it when it maps to
 * any non-public address, so the connection is refused before a socket is
 * ever opened.
 *
 * All addresses a hostname resolves to must be public — if any resolves into a
 * blocked range the host is rejected, which also blunts DNS-rebinding tricks
 * that pair one public and one private answer.
 */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";

/** Thrown by `assertHostAllowed` when a host resolves to a non-public address. */
export class BlockedHostError extends Error {
  constructor(public readonly host: string) {
    super(`host ${host} is not permitted`);
    this.name = "BlockedHostError";
  }
}

/** Parse a dotted-quad IPv4 string into its unsigned 32-bit value, or null. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** True when an IPv4 address falls in a loopback/private/link-local/reserved range. */
function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true; // unparseable → treat as unsafe
  const inRange = (base: string, maskBits: number): boolean => {
    const baseInt = ipv4ToInt(base);
    if (baseInt === null) return false;
    const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
    return (value & mask) === (baseInt & mask);
  };
  return (
    inRange("0.0.0.0", 8) || // "this network"
    inRange("10.0.0.0", 8) || // RFC1918
    inRange("100.64.0.0", 10) || // CGNAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link-local (incl. 169.254.169.254 metadata)
    inRange("172.16.0.0", 12) || // RFC1918
    inRange("192.0.0.0", 24) || // IETF protocol assignments
    inRange("192.168.0.0", 16) || // RFC1918
    inRange("198.18.0.0", 15) || // benchmarking
    inRange("240.0.0.0", 4) // reserved + 255.255.255.255 broadcast
  );
}

/** Expand an IPv6 address string into its 16 bytes, or null if unparseable. */
function ipv6ToBytes(ip: string): number[] | null {
  let head = ip;
  let tail = "";
  const doubleColon = ip.indexOf("::");
  if (doubleColon !== -1) {
    head = ip.slice(0, doubleColon);
    tail = ip.slice(doubleColon + 2);
  }

  const expand = (segment: string): number[] | null => {
    if (segment === "") return [];
    const bytes: number[] = [];
    for (const group of segment.split(":")) {
      // An embedded IPv4 tail (e.g. ::ffff:192.168.0.1) contributes 2 groups.
      if (group.includes(".")) {
        const v4 = ipv4ToInt(group);
        if (v4 === null) return null;
        bytes.push((v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff);
        bytes.push((v4 >>> 8) & 0xff, v4 & 0xff);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      const word = parseInt(group, 16);
      bytes.push((word >> 8) & 0xff, word & 0xff);
    }
    return bytes;
  };

  const headBytes = expand(head);
  const tailBytes = expand(tail);
  if (headBytes === null || tailBytes === null) return null;

  if (doubleColon === -1) {
    return headBytes.length === 16 ? headBytes : null;
  }
  const fill = 16 - headBytes.length - tailBytes.length;
  if (fill < 0) return null;
  return [...headBytes, ...new Array<number>(fill).fill(0), ...tailBytes];
}

/** True when an IPv6 address is loopback/unspecified/ULA/link-local/mapped-private. */
function isBlockedIpv6(ip: string): boolean {
  const bytes = ipv6ToBytes(ip);
  if (bytes === null || bytes.length !== 16) return true;

  const allZeroBut = (lastByte: number): boolean =>
    bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === lastByte;
  if (allZeroBut(0)) return true; // :: unspecified
  if (allZeroBut(1)) return true; // ::1 loopback

  // IPv4-mapped ::ffff:a.b.c.d — judge by the embedded IPv4 address.
  const isMapped =
    bytes.slice(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (isMapped) {
    return isBlockedIpv4(bytes.slice(12).join("."));
  }

  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  if ((b0 & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true; // fe80::/10 link-local
  return false;
}

/** True when a literal IP string is in any blocked range. */
function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true; // not a recognizable IP → refuse
}

/**
 * Reject `host` when it resolves to any non-public address, by throwing
 * `BlockedHostError`. `host` may be an IP literal (checked directly, no DNS)
 * or a name (resolved first).
 *
 * Resolution failure is deliberately *not* an error here: a host that doesn't
 * resolve has no address to open a socket to, so it's not an SSRF target — the
 * real connector will simply fail to connect. Blocking only ever fires on an
 * address that resolved into a private/loopback/link-local range, which is the
 * case that actually matters.
 */
export async function assertHostAllowed(host: string): Promise<void> {
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) throw new BlockedHostError(host);
    return;
  }

  let results: LookupAddress[];
  try {
    results = await lookup(host, { all: true });
  } catch {
    return; // unresolvable → nothing to probe, let the connector fail naturally
  }
  for (const { address } of results) {
    if (isBlockedIp(address)) throw new BlockedHostError(host);
  }
}
