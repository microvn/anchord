import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import { AuthGuard } from "./app/auth-guard";
import { AppShell } from "./app/app-shell";
import { SignInScreen } from "./features/auth/sign-in-screen";

// One QueryClient for the app's server-state layer. web-core wires the provider so every
// feature `-ui` spec can use react-query with the typed client as the fetcher (S-002).
const queryClient = new QueryClient();

// The route table: /signin is public; everything under AuthGuard is protected (AS-004).
// The Router itself is provided in main.tsx so tests can supply MemoryRouter instead.
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInScreen />} />
      <Route element={<AuthGuard />}>
        <Route element={<AppShell />}>
          <Route index element={<Welcome />} />
        </Route>
      </Route>
    </Routes>
  );
}

// Minimal authenticated landing — real feature screens replace this via their -ui specs.
function Welcome() {
  return (
    <section className="px-4 py-8 text-muted">
      <h2 className="font-serif text-xl text-ink">Welcome</h2>
      <p className="mt-1 text-sm">Your workspace is ready.</p>
    </section>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppRoutes />
    </QueryClientProvider>
  );
}
