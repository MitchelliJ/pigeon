import type { JSX } from "solid-js";
import { Show } from "solid-js";
import type { Stats } from "@pigeon/shared";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default function Hero(props: {
  name: string;
  stats: Stats;
}): JSX.Element {
  const needs = () => props.stats.urgent + props.stats.important;

  return (
    <header class="hero rise">
      <h1 class="hero-title">
        {greeting()}, {props.name}.
        <Show
          when={needs() > 0}
          fallback={
            <span class="hero-title-sub">You're all caught up today.</span>
          }
        >
          <span class="hero-title-sub">
            {needs()} {needs() === 1 ? "thing" : "things"} actually{" "}
            {needs() === 1 ? "needs" : "need"} you today.
          </span>
        </Show>
      </h1>
    </header>
  );
}
