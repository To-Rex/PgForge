import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { en } from './en.js'
import { ru } from './ru.js'
import { uz } from './uz.js'

export const LANGUAGES = [
  { code: 'uz', label: "O'zbekcha" },
  { code: 'ru', label: 'Русский' },
  { code: 'en', label: 'English' },
] as const

export type LangCode = (typeof LANGUAGES)[number]['code']

const stored = ((): LangCode => {
  try {
    const value = localStorage.getItem('pgforge.lang')
    return value === 'ru' || value === 'en' || value === 'uz' ? value : 'uz'
  } catch {
    return 'uz'
  }
})()

void i18n.use(initReactI18next).init({
  resources: {
    uz: { translation: uz },
    ru: { translation: ru },
    en: { translation: en },
  },
  lng: stored,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnEmptyString: false,
})

export function setLanguage(code: LangCode): void {
  void i18n.changeLanguage(code)
  try {
    localStorage.setItem('pgforge.lang', code)
    document.documentElement.lang = code
  } catch {
    /* storage unavailable */
  }
}

export default i18n
