import { env } from '../shared/config/env'
import styles from './App.module.css'

/**
 * Application shell -- Phase 1 foundation only.
 *
 * This component intentionally contains no financial logic, no data
 * fetching, and no domain features. It exists to prove out the app's
 * structural foundation (routing-free shell, design tokens, environment
 * wiring) ahead of later phases. See docs/ARCHITECTURE-GUARDRAILS.md.
 */
function App() {
  return (
    <div className={styles.shell}>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <header className={styles.header}>
        <div className={styles.headerInner}>
          <img
            className={styles.brandMark}
            src="/icons/icon-192.png"
            alt=""
            width={32}
            height={32}
          />
          <p className={styles.brandName}>CommitteeApp</p>
        </div>
      </header>

      <main id="main-content" className={styles.main}>
        <div className={styles.card}>
          <h1>Foundation build</h1>
          <p>
            This is the Phase 1 project foundation: a React + TypeScript + Vite
            Progressive Web App shell. No financial features are implemented yet
            -- those arrive in later phases, built on top of server-side
            Financial RPCs rather than in the client.
          </p>

          <ul className={styles.statusList}>
            <li className={styles.statusRow}>
              <span
                className={`${styles.statusDot} ${styles.statusDotOk}`}
                aria-hidden="true"
              />
              <span>Application shell loaded</span>
            </li>
            <li className={styles.statusRow}>
              <span
                className={`${styles.statusDot} ${
                  env.isSupabaseConfigured
                    ? styles.statusDotOk
                    : styles.statusDotPending
                }`}
                aria-hidden="true"
              />
              <span>
                Supabase client foundation:{' '}
                {env.isSupabaseConfigured
                  ? 'configured'
                  : 'not yet configured (see .env.example)'}
              </span>
            </li>
          </ul>
        </div>
      </main>

      <footer className={styles.footer}>
        <p>CommitteeApp -- Phase 1 foundation build.</p>
      </footer>
    </div>
  )
}

export default App
