import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface SidebarContextValue {
  // Mobile drawer + back-compat (existing behavior, unchanged).
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  isMobile: boolean;
  // Pinned desktop mode: expanded | collapsed. Desktop-only.
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
  toggleCollapsed: () => void;
  // Ephemeral peek (hover flyout). Only meaningful on desktop, collapsed,
  // hover-capable pointer. Never persisted.
  peeking: boolean;
  setPeeking: (next: boolean) => void;
  // Route-requested collapse: a route may default the app sidebar to collapsed.
  // Lower precedence than an explicit user pin. Wired by Layout/routes (Task 5).
  routeRequestsCollapsed: boolean;
  setRouteRequestsCollapsed: (next: boolean) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

const MOBILE_BREAKPOINT = 768;
const COLLAPSED_STORAGE_KEY = "paperclip.sidebar.collapsed";
const PEEK_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

// Tri-state read of the persisted user pin:
//   true  → pinned collapsed ("1")
//   false → pinned expanded ("0")
//   null  → no pin (fall through to route request, then global default)
// Read synchronously in the state initializer so first paint matches the
// persisted mode (mirrors the `paperclip.sidebar.width` pattern in
// ResizableSidebarPane and avoids an expand→collapse flash).
function readStoredCollapsed(): boolean | null {
  if (typeof window === "undefined") return null;

  try {
    const stored = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
    return null;
  } catch {
    return null;
  }
}

function writeStoredCollapsed(value: boolean) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Storage can be unavailable in private contexts; pinning should still
    // work for the current session.
  }
}

function readPointerCanPeek(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  try {
    return window.matchMedia(PEEK_POINTER_QUERY).matches;
  } catch {
    return false;
  }
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= MOBILE_BREAKPOINT);

  // `null` = unpinned; an explicit user pin takes precedence over route request.
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(() => readStoredCollapsed());
  const [routeRequestsCollapsed, setRouteRequestsCollapsed] = useState(false);
  const [rawPeeking, setRawPeeking] = useState(false);
  const [pointerCanPeek, setPointerCanPeek] = useState(() => readPointerCanPeek());

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      setSidebarOpen(!e.matches);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(PEEK_POINTER_QUERY);
    const onChange = (e: MediaQueryListEvent) => setPointerCanPeek(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // Precedence (highest wins): explicit user pin > route request > default expanded.
  const desktopCollapsed = userCollapsed !== null ? userCollapsed : routeRequestsCollapsed;
  // Collapsed/peek are desktop-only; mobile always uses the drawer. The user
  // pin is preserved across the breakpoint and reapplies on the desktop side.
  const collapsed = isMobile ? false : desktopCollapsed;
  // Peek only applies when collapsed on a hover-capable pointer.
  const peeking = rawPeeking && collapsed && pointerCanPeek;

  const setCollapsed = useCallback((next: boolean) => {
    setUserCollapsed(next);
    writeStoredCollapsed(next);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(!desktopCollapsed);
  }, [desktopCollapsed, setCollapsed]);

  const setPeeking = useCallback((next: boolean) => {
    setRawPeeking(next);
  }, []);

  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  const value = useMemo<SidebarContextValue>(
    () => ({
      sidebarOpen,
      setSidebarOpen,
      toggleSidebar,
      isMobile,
      collapsed,
      setCollapsed,
      toggleCollapsed,
      peeking,
      setPeeking,
      routeRequestsCollapsed,
      setRouteRequestsCollapsed,
    }),
    [
      sidebarOpen,
      toggleSidebar,
      isMobile,
      collapsed,
      setCollapsed,
      toggleCollapsed,
      peeking,
      setPeeking,
      routeRequestsCollapsed,
    ],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    throw new Error("useSidebar must be used within SidebarProvider");
  }
  return ctx;
}
