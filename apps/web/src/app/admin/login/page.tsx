import { redirect } from 'next/navigation';
import { getAdminSession } from '@/lib/admin-auth';
import { AdminLogin } from '@/components/admin-login';
export default async function Page() {
  if (await getAdminSession()) redirect('/admin');
  return <AdminLogin />;
}
