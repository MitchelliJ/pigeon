import type {
  Channel,
  ChannelKind,
  DashboardData,
  DeliveryMode,
  Digest,
} from "./index";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

type ExpectedChannel = {
  id: string;
  kind: "discord";
  status: "active" | "error";
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

type ExpectedDigest = {
  mode: "daily" | "quiet";
  digestTime: string;
  digestDays: readonly Weekday[];
  timezone: "UTC";
  lastSuccessfulDigestAt: string | null;
};

type _ChannelKindIsDiscordOnly = Assert<IsEqual<ChannelKind, "discord">>;
type _DeliveryModeIsDailyOrQuiet = Assert<
  IsEqual<DeliveryMode, "daily" | "quiet">
>;

type _ChannelHasFeature7Shape = Assert<
  Channel extends ExpectedChannel ? true : false
>;
type _ChannelExposesOnlyFeature7Keys = Assert<
  IsEqual<keyof Channel, keyof ExpectedChannel>
>;

type _DigestHasFeature7Shape = Assert<
  Digest extends ExpectedDigest ? true : false
>;
type _DigestExposesOnlyFeature7Keys = Assert<
  IsEqual<keyof Digest, keyof ExpectedDigest>
>;

type _DashboardHasOneNullableChannel = Assert<
  IsEqual<DashboardData["channel"], Channel | null>
>;
type _DashboardDigestUsesFeature7Contract = Assert<
  IsEqual<DashboardData["digest"], Digest>
>;
type _DashboardDoesNotExposeChannelsArray = Assert<
  "channels" extends keyof DashboardData ? false : true
>;
