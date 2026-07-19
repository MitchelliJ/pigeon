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

export default function EditScheduleDialog(props: {
  open: boolean;
  time: string;
  days: readonly Weekday[];
  onClose: () => void;
  onSave: (time: string, days: readonly Weekday[]) => Promise<void>;
}): JSX.Element {
  const [time, setTime] = createSignal(untrack(() => props.time));
  const [days, setDays] = createSignal<Set<Weekday>>(
    untrack(() => scheduleDays(props.days)),
  );
  const [isSaving, setIsSaving] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);

  createEffect(() => {
    if (props.open) {
      setTime(props.time);
      setDays(scheduleDays(props.days));
      setIsSaving(false);
      setErrorMessage(null);
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

  function close() {
    if (!isSaving()) props.onClose();
  }

  async function save() {
    if (isSaving() || days().size === 0) return;
    const ordered = WEEKDAYS.filter((d) => days().has(d));
    setIsSaving(true);
    setErrorMessage(null);
    try {
      await props.onSave(time(), ordered);
      props.onClose();
    } catch {
      setErrorMessage(
        "Could not save your schedule. Your changes are still open.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Show when={props.open}>
      <Portal>
        <div class="modal-overlay" onClick={close}>
          <div
            class="modal modal-sm rise"
            role="dialog"
            aria-modal="true"
            aria-label="Edit digest schedule"
            aria-busy={isSaving()}
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
                disabled={isSaving()}
                onClick={close}
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
                  disabled={isSaving()}
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
                      disabled={isSaving()}
                      onClick={() => toggle(day)}
                    >
                      {day}
                    </button>
                  )}
                </For>
              </div>
            </div>

            <Show when={errorMessage()}>
              {(message) => (
                <p class="auth-error" role="alert">
                  {message()}
                </p>
              )}
            </Show>

            <div class="modal-actions">
              <button class="btn" disabled={isSaving()} onClick={close}>
                Cancel
              </button>
              <button
                class="btn btn-primary"
                style={{ flex: 1 }}
                disabled={days().size === 0 || isSaving()}
                onClick={() => void save()}
              >
                {isSaving() ? "Saving…" : "Save schedule"}
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
