import "./globals.css";

export const metadata = {
  title: "EvidenceGraph",
  description: "Evidence-backed research workspace",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
