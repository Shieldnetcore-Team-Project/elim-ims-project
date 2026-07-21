import { useEffect, useState } from "react";

const KEY = "fmis.theme";

export function useTheme() {
  const [theme, setThemeState] = useState<"light" | "dark">("light");
  useEffect(() => {
    const stored = (localStorage.getItem(KEY) as "light" | "dark" | null) ?? "light";
    setThemeState(stored);
    document.documentElement.classList.toggle("dark", stored === "dark");
  }, []);
  const setTheme = (t: "light" | "dark") => {
    localStorage.setItem(KEY, t);
    document.documentElement.classList.toggle("dark", t === "dark");
    setThemeState(t);
  };
  return { theme, setTheme, toggle: () => setTheme(theme === "dark" ? "light" : "dark") };
}
