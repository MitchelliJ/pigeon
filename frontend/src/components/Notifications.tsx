import type { JSX, ParentProps } from "solid-js";
import {
  createContext,
  createSignal,
  For,
  onCleanup,
  useContext,
} from "solid-js";
import { Portal } from "solid-js/web";

export type NotificationKind = "success" | "error" | "info";

interface Notification {
  id: string;
  kind: NotificationKind;
  message: string;
}

interface NotificationApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  dismiss: (id: string) => void;
}

const NotificationContext = createContext<NotificationApi>();
const MAX_VISIBLE = 4;
const SUCCESS_DURATION_MS = 5_000;
const INFO_DURATION_MS = 6_000;

export function NotificationProvider(props: ParentProps): JSX.Element {
  const [notifications, setNotifications] = createSignal<Notification[]>([]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const deadlines = new Map<string, number>();
  const remaining = new Map<string, number>();
  let nextId = 0;

  function clearTimer(id: string): void {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
    deadlines.delete(id);
  }

  function dismiss(id: string): void {
    clearTimer(id);
    remaining.delete(id);
    setNotifications((current) => current.filter((item) => item.id !== id));
  }

  function startTimer(id: string, duration: number): void {
    clearTimer(id);
    remaining.set(id, duration);
    deadlines.set(id, Date.now() + duration);
    timers.set(
      id,
      setTimeout(() => dismiss(id), duration),
    );
  }

  function pause(id: string): void {
    const deadline = deadlines.get(id);
    if (deadline === undefined) return;
    remaining.set(id, Math.max(0, deadline - Date.now()));
    clearTimer(id);
  }

  function resume(id: string): void {
    const duration = remaining.get(id);
    if (duration === undefined) return;
    startTimer(id, Math.max(duration, 250));
  }

  function add(
    kind: NotificationKind,
    message: string,
    duration: number | null,
  ): void {
    const id = `notification-${String(++nextId)}`;
    const notification = { id, kind, message };
    setNotifications((current) => {
      const next = [...current, notification];
      const removed = next.slice(0, Math.max(0, next.length - MAX_VISIBLE));
      for (const item of removed) {
        clearTimer(item.id);
        remaining.delete(item.id);
      }
      return next.slice(-MAX_VISIBLE);
    });
    if (duration !== null) startTimer(id, duration);
  }

  const api: NotificationApi = {
    success: (message) => add("success", message, SUCCESS_DURATION_MS),
    error: (message) => add("error", message, null),
    info: (message) => add("info", message, INFO_DURATION_MS),
    dismiss,
  };

  onCleanup(() => {
    for (const timer of timers.values()) clearTimeout(timer);
  });

  return (
    <NotificationContext.Provider value={api}>
      {props.children}
      <Portal>
        <div
          class="notification-viewport"
          aria-label="Notifications"
          aria-relevant="additions"
        >
          <For each={notifications()}>
            {(notification) => (
              <div
                class={`notification notification-${notification.kind}`}
                role={notification.kind === "error" ? "alert" : "status"}
                aria-live={
                  notification.kind === "error" ? "assertive" : "polite"
                }
                aria-atomic="true"
                onMouseEnter={() => pause(notification.id)}
                onMouseLeave={(event) => {
                  if (!event.currentTarget.contains(document.activeElement)) {
                    resume(notification.id);
                  }
                }}
                onFocusIn={() => pause(notification.id)}
                onFocusOut={(event) => {
                  const nextTarget = event.relatedTarget;
                  if (
                    !(nextTarget instanceof Node) ||
                    !event.currentTarget.contains(nextTarget)
                  ) {
                    resume(notification.id);
                  }
                }}
              >
                <div class="notification-copy">
                  <strong class="notification-kind">
                    {notification.kind === "success"
                      ? "Success"
                      : notification.kind === "error"
                        ? "Something went wrong"
                        : "Notice"}
                  </strong>
                  <span>{notification.message}</span>
                </div>
                <button
                  type="button"
                  class="notification-dismiss"
                  aria-label="Dismiss notification"
                  onClick={() => dismiss(notification.id)}
                >
                  ×
                </button>
              </div>
            )}
          </For>
        </div>
      </Portal>
    </NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationApi {
  const notifications = useContext(NotificationContext);
  if (notifications === undefined) {
    throw new Error(
      "useNotifications must be used inside NotificationProvider",
    );
  }
  return notifications;
}
