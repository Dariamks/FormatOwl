import { redirect } from 'next/navigation';
import { getAdminSession } from '@/lib/admin-auth';
import { AdminHeader } from '@/components/admin-header';
export default async function Layout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  if (!session) redirect('/admin/login');
  return (
    <>
      <AdminHeader username={session.username} />
      <main className="admin-main">{children}</main>
    </>
  );
}
