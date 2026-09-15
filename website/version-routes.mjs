/** @param {{version: string, locale?: string, page?: string, pages?: Record<string, Record<string, string[]>>}} options */
export function routeForVersion({ version, locale = "root", page = "", pages }) {
  const language = locale === "ko" ? "ko" : "root";
  const normalizedPage = page.replace(/^\/+|\/+$/gu, "");
  const available = pages?.[version]?.[language];
  const targetPage = Array.isArray(available) && available.includes(normalizedPage) ? normalizedPage : "";
  const base = version === "latest" ? "/SQLBraid/latest" : `/SQLBraid/v/${encodeURIComponent(version)}`;
  return `${base}${language === "ko" ? "/ko" : ""}/${targetPage ? `${targetPage}/` : ""}`;
}
