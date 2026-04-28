// Shared Mini App header. Renders the Parley lockup so every page has a
// consistent brand mark in Telegram's webview chrome. Source asset is
// /artifacts/svg/lockup-horizontal.svg, mirrored into /public/ via
// `pnpm miniapp:sync-assets`.

export function MiniAppHeader() {
  return (
    <div style={{ marginBottom: 16 }}>
      <img
        src="/lockup-horizontal.svg"
        alt="Parley"
        width={180}
        height={36}
        style={{ display: "block" }}
      />
    </div>
  );
}
