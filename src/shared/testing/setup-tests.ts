import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Ensure each test starts from a clean DOM -- required because
// `test.globals` is intentionally `false` in vite.config.ts (explicit
// imports over implicit globals), so React Testing Library's automatic
// afterEach cleanup does not register itself.
afterEach(() => {
  cleanup()
})
