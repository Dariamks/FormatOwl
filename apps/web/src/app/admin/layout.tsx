import './admin.css';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'FormatOwl 管理后台', robots: { index: false, follow: false } };
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="admin-root" lang="zh-CN" dir="ltr">
      {children}
    </div>
  );
}
