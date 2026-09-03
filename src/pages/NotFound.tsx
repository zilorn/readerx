import { useNavigate } from "@solidjs/router";
import { BookOpenIcon } from "../components/icons";

export default function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div class="nf">
      <BookOpenIcon size={58} class="nf__icon" />
      <p class="nf__code">404</p>
      <p class="nf__title">页面走丢了</p>
      <p class="nf__desc">你访问的页面不存在或已被移除</p>
      <button class="btn-primary" onClick={() => navigate("/")}>
        回到书架
      </button>
    </div>
  );
}
