import { QueryClientProvider } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import { AuthGuard } from "./app/auth-guard";
import { AppShell } from "./app/app-shell";
import { SignInScreen } from "./features/auth/sign-in-screen";
import { createQueryClient } from "./app/query-client";
import { SessionExpiryListener } from "./app/session-expiry-listener";
import { BootstrapPanel } from "./app/bootstrap-panel";
import { ThemeProvider } from "./app/theme-provider";

// One shared QueryClient for the app's server-state layer (S-002). Its cache-level onError
// centralizes session-expiry handling: any query that comes back UNAUTHENTICATED bounces the
// user to /signin via SessionExpiryListener. Every feature `-ui` screen fetches through this
// same client (via useApiQuery), so the resilient behavior is consistent, not per-screen.
const queryClient = createQueryClient();

// The route table: /signin is public; everything under AuthGuard is protected (AS-004).
// The Router itself is provided in main.tsx so tests can supply MemoryRouter instead.
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInScreen />} />
      <Route element={<AuthGuard />}>
        <Route element={<AppShell />}>
          {/* S-002: the index route is a representative authenticated read through the
              shared client — it exercises the resilient-fetch + session-expiry layer in the
              real app. Feature `-ui` specs replace it with their own screens. */}
          <Route index element={<BootstrapPanel />} />
        </Route>
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        {/* Mounted inside the Router (main.tsx) so it can navigate on session expiry. */}
        <SessionExpiryListener />
        <AppRoutes />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
