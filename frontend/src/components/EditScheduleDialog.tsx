import type { JSX } from "solid-js";
import { createEffect, createSignal, For, Show, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import type { Weekday } from "@pigeon/shared";
import { WEEKDAYS } from "@pigeon/shared";
import { formatTime } from "../lib/format";
import { CloseIcon } from "./visuals";

export default function EditScheduleDialog(props: {
  open: boolean;
  time: string;
  days: Weekday[];
  onClose: () => void;
  onSave: (time: string, days: Weekday[]) => void;
}): JSX.Element {
  const [time, setTime] = createSignal(untrack(() => props.time));
  const [days, setDays] = createSignal<Set<Weekday>>(
    untrack(() => new Set(props.days)),
  );

  createEffect(() => {
    if (props.open) {
      setTime(props.time);
      setDays(new Set(props.days));
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
    props.onSave(time(), ordered);
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
                <span class="time-preview">{formatTime(time())}</span>
              </div>
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
