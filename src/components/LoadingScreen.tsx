export function LoadingScreen(props: { label?: string }) {
  return (
    <div class="loading" role="status">
      <span class="loading__spinner" aria-hidden="true" />
      <span class="loading__label">{props.label ?? "加载中…"}</span>
    </div>
  );
}
