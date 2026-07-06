import type { JSX } from "solid-js";
import type { Category } from "@pigeon/shared";

export default function StatCard(props: {
  tone: Category;
  label: string;
  count: number;
  desc: string;
  delay?: number;
}): JSX.Element {
  return (
    <article
      class={`stat ${props.tone} rise`}
      style={{ "animation-delay": `${props.delay ?? 0}ms` }}
    >
      <span class="stat-accent" />
      <div class="stat-label">{props.label}</div>
      <div class="stat-num">{props.count}</div>
      <div class="stat-desc">{props.desc}</div>
    </article>
  );
}
