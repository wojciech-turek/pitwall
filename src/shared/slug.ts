const EXPLICIT: Record<string, string> = { ł: 'l', Ł: 'l', ø: 'o', Ø: 'o', ß: 'ss', đ: 'd', Đ: 'd' }
const MAX_LEN = 40

export function slugify(title: string): string {
  const mapped = title.replace(/[łŁøØßđĐ]/g, (c) => EXPLICIT[c])
  const slug = mapped
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LEN)
    .replace(/-+$/g, '')
  return slug || 'session'
}

export function defaultBranchName(slug: string): string {
  return `pitwall/${slug}`
}
