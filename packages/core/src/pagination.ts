export const listPageSize = 10;
export type Pagination = { page: number; pageSize: number; total: number; totalPages: number };

export function pagination(total: number, requestedPage: number): Pagination {
  const totalPages = Math.max(1, Math.ceil(total / listPageSize));
  return { page: Math.min(requestedPage, totalPages), pageSize: listPageSize, total, totalPages };
}
