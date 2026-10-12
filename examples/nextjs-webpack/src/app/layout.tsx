import type { ReactNode } from "react";

export const metadata = { title: "SQLBraid + Next.js" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: "48rem" }}>{children}</body>
    </html>
  );
}
