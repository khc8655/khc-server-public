export interface AppPageMeta {
  title?: string;
  defaults?: Record<string, unknown>;
}

/** 只扫描 apps/<app>/page.tsx；host-ops 等组件目录没有 page.tsx，不会成为 /apps/:app 页面。 */
const modules = import.meta.glob('./*/page.tsx', { eager: true }) as Record<
  string,
  { meta?: AppPageMeta }
>;

/** 加一个应用页面 = 新增 src/apps/<app>/page.tsx，不改路由 */
export function getAppMeta(app: string): AppPageMeta {
  return modules[`./${app}/page.tsx`]?.meta ?? {};
}
