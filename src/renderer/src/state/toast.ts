import { create } from 'zustand'

export const useToast = create<{ message: string | null; show(m: string): void; clear(): void }>()((set) => ({
  message: null,
  show: (message) => {
    set({ message })
    setTimeout(() => set((s) => (s.message === message ? { message: null } : s)), 6000)
  },
  clear: () => set({ message: null })
}))
