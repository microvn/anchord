import { Brandmark, Icon } from "../../components/icon";

// AuthAside — the right-hand brand / marketing pane (Anchord-Design AuthAside).
// Purely presentational chrome wrapped around the sign-in / sign-up form. Hidden
// below 820px (see styles/auth.css), so the form pane stands alone on small screens.
const FEATURES: ReadonlyArray<[string, string]> = [
  ["shield", "Self-hosted, single binary"],
  ["docs", "HTML · Markdown · images"],
  ["share", "Versioned, threaded annotations"],
];

export function AuthAside() {
  return (
    <div className="auth-aside">
      <div className="grid-bg" />
      <div className="aside-inner">
        <div className="auth-brand" style={{ marginBottom: 34 }}>
          <Brandmark size={24} />
          <span className="anchord-brand-name" style={{ fontSize: 19 }}>
            anchord
          </span>
        </div>
        <div className="quote">
          Share and annotate AI-generated docs, <span className="teal">self-hosted</span> — the
          data stays in your hands.
        </div>
        <div className="feature-list">
          {FEATURES.map(([ic, label]) => (
            <div className="f" key={label}>
              <span className="fi">
                <Icon name={ic} size={15} />
              </span>
              {label}
            </div>
          ))}
        </div>
        <div className="meta">v1.0 · your server</div>
      </div>
    </div>
  );
}
