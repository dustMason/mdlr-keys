import { useState, type FormEvent } from "react";
import { pb } from "../backend/pocketbase";

interface AuthScreenProps {
  onAuthenticated: () => void;
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);

    try {
      const cleanUsername = username.trim();
      if (mode === "signup") {
        await pb.collection("users").create({
          username: cleanUsername,
          password,
          passwordConfirm,
        });
      }

      await pb.collection("users").authWithPassword(cleanUsername, password);
      onAuthenticated();
    } catch (caught) {
      setError(authErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="authShell">
      <header className="authHeader">
        <h1>MDLR</h1>
      </header>
      <section className="authPanel" aria-label="Account">
        <div className="authModeSwitch" role="tablist" aria-label="Auth mode">
          <button
            type="button"
            className={mode === "login" ? "isActive" : ""}
            onClick={() => setMode("login")}
          >
            log in
          </button>
          <button
            type="button"
            className={mode === "signup" ? "isActive" : ""}
            onClick={() => setMode("signup")}
          >
            sign up
          </button>
        </div>

        <form className="authForm" onSubmit={submit}>
          <label>
            <span>username</span>
            <input
              type="text"
              value={username}
              autoComplete="username"
              minLength={3}
              maxLength={64}
              pattern={"[A-Za-z0-9_.\\-]+"}
              required
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label>
            <span>password</span>
            <input
              type="password"
              value={password}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              minLength={8}
              required
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {mode === "signup" ? (
            <label>
              <span>confirm</span>
              <input
                type="password"
                value={passwordConfirm}
                autoComplete="new-password"
                minLength={8}
                required
                onChange={(event) => setPasswordConfirm(event.target.value)}
              />
            </label>
          ) : null}
          {error ? <p className="authError">{error}</p> : null}
          <button type="submit" disabled={busy}>
            {busy ? "working" : mode === "signup" ? "create account" : "log in"}
          </button>
        </form>
      </section>
    </main>
  );
}

function authErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Authentication failed.";
}
