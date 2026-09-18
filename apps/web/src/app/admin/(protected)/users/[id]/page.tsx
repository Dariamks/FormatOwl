import { AdminUserDetail } from '@/components/admin-user-detail';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <AdminUserDetail userId={(await params).id} />;
}
