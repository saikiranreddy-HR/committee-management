import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import App from './App'

describe('App', () => {
  it('renders the brand name', () => {
    render(<App />)
    expect(screen.getByText('CommitteeApp')).toBeInTheDocument()
  })

  it('renders the Phase 1 foundation heading', () => {
    render(<App />)
    expect(
      screen.getByRole('heading', { name: /foundation build/i }),
    ).toBeInTheDocument()
  })

  it('renders a skip link for keyboard users', () => {
    render(<App />)
    expect(screen.getByText(/skip to main content/i)).toBeInTheDocument()
  })

  it('exposes exactly one main landmark', () => {
    render(<App />)
    expect(screen.getAllByRole('main')).toHaveLength(1)
  })
})
