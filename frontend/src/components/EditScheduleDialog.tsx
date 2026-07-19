import type { JSX } from "solid-js";
import { createEffect, createSignal, For, Show, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import type { Weekday } from "@pigeon/shared";
import { WEEKDAYS } from "@pigeon/shared";
import { formatTime } from "../lib/format";
import { CloseIcon } from "./visuals";

function scheduleDays(incoming: readonly Weekday[]): Set<Weekday> {
  return new Set(incoming.length > 0 ? incoming : WEEKDAYS);
}

const FALLBACK_TIMEZONES = [
  "Europe/Amsterdam",
  "Europe/Brussels",
  "Europe/London",
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Australia/Sydney",
];

function timezoneOptions(current: string): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  const supported = intl.supportedValuesOf?.("timeZone") ?? [];
  return [...new Set([...supported, ...FALLBACK_TIMEZONES, current])].sort(
    (a, b) => a.localeCompare(b),
  );
}

export default function EditScheduleDialog(props: {
  open: boolean;
  time: string;
  days: readonly Weekday[];
  timezone: string;
  onClose: () => void;
  onSave: (time: string, days: readonly Weekday[], timezone: string) => void;
}): JSX.Element {
  const [time, setTime] = createSignal(untrack(() => props.time));
  const [days, setDays] = createSignal<Set<Weekday>>(
    untrack(() => scheduleDays(props.days)),
  );
  const [timezone, setTimezone] = createSignal(untrack(() => props.timezone));

  createEffect(() => {
    if (props.open) {
      setTime(props.time);
      setDays(scheduleDays(props.days));
      setTimezone(props.timezone);
    }
  });

  function toggle(day: Weekday) {
    setDays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) {
        next.delete(day);
      } else {
        next.add(day);
      }
      return next;
    });
  }

  function save() {
    const ordered = WEEKDAYS.filter((d) => days().has(d));
    props.onSave(time(), ordered, timezone());
    props.onClose();
  }

  return (
    <Show when={props.open}>
      <Portal>
        <div class="modal-overlay" onClick={() => props.onClose()}>
          <div
            class="modal modal-sm rise"
            role="dialog"
            aria-modal="true"
            aria-label="Edit digest schedule"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="modal-head">
              <div>
                <div class="modal-eyebrow">Smart digest</div>
                <h2 class="modal-title">Edit schedule</h2>
              </div>
              <button
                class="icon-btn"
                aria-label="Close"
                onClick={() => props.onClose()}
              >
                <CloseIcon />
              </button>
            </div>

            <div class="field">
              <label class="field-label">Send at</label>
              <div class="time-pick">
                <input
                  class="input"
                  type="time"
                  value={time()}
                  onInput={(e) => setTime(e.currentTarget.value)}
                />
                <span class="time-preview">
                  {formatTime(time())} in {timezone()}
                </span>
              </div>
            </div>

            <div class="field">
              <label class="field-label" for="digest-timezone">
                Timezone
              </label>
              <select
                id="digest-timezone"
                class="select"
                value={timezone()}
                onInput={(e) => setTimezone(e.currentTarget.value)}
              >
                <For each={timezoneOptions(props.timezone)}>
                  {(zone) => <option value={zone}>{zone}</option>}
                </For>
              </select>
              <p class="hint">Times follow daylight-saving changes.</p>
            </div>

            <div class="field">
              <label class="field-label">On these days</label>
              <div class="day-pills">
                <For each={WEEKDAYS}>
                  {(day) => (
                    <button
                      type="button"
                      class="day-pill"
                      classList={{ on: days().has(day) }}
                      aria-pressed={days().has(day)}
                      onClick={() => toggle(day)}
                    >
                      {day}
                    </button>
                  )}
                </For>
              </div>
            </div>

            <div class="modal-actions">
              <button class="btn" onClick={() => props.onClose()}>
                Cancel
              </button>
              <button
                class="btn btn-primary"
                style={{ flex: 1 }}
                disabled={days().size === 0}
                onClick={save}
              >
                Save schedule
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
