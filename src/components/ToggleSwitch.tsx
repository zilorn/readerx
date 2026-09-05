/**
 * iOS 风格小开关（勿命名 Switch：与 Solid 内置流程组件重名会被编译器接管）。
 * 由阅读设置的底部状态栏开关与设置页的书架来源筛选开关共用。
 */
export function ToggleSwitch(props: {
  on: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      class="relative h-[26px] w-[46px] flex-none cursor-pointer rounded-full transition-colors duration-150"
      classList={{ "bg-accent": props.on, "bg-text-3/40": !props.on }}
      onClick={props.onChange}
    >
      <span
        class="absolute top-[3px] h-5 w-5 rounded-full bg-surface shadow-md shadow-black/20 transition-[left] duration-150"
        style={{ left: props.on ? "23px" : "3px" }}
      />
    </button>
  );
}
