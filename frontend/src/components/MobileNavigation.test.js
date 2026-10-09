import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import MobileNavigation from "./MobileNavigation";

describe("mobile navigation", () => {
  let root, container;
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  test.each(["/", "/search", "/social"])("marks only the current route: %s", (path) => {
    act(() => root.render(<MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <MobileNavigation darkMode />
    </MemoryRouter>));
    expect(container.querySelectorAll("a")).toHaveLength(3);
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(container.querySelector('[aria-current="page"]').getAttribute("href")).toBe(path);
    expect(container.querySelector("nav").classList.contains("dark")).toBe(true);
  });
  test("closes the menu on navigation and preserves link semantics", () => {
    const onNavigate = jest.fn();
    act(() => root.render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <MobileNavigation darkMode={false} onNavigate={onNavigate} />
    </MemoryRouter>));
    act(() => container.querySelector('a[href="/search"]').dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-current="page"]').textContent).toBe("Cerca");
    expect(container.querySelector("nav").getAttribute("aria-label")).toBe("Navigazione rapida");
  });
  test("offers a labelled account action and displays its expanded state", () => {
    const onAccountToggle = jest.fn();
    act(() => root.render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <MobileNavigation username="marco" accountOpen onAccountToggle={onAccountToggle} />
    </MemoryRouter>));
    const button = container.querySelector('button[aria-label="Account"]');
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe("account-menu-panel");
    expect(button.querySelector('.mobile-navigation-avatar').textContent).toBe("M");
    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onAccountToggle).toHaveBeenCalledTimes(1);
    expect([...container.querySelectorAll('a')].every(link => link.getAttribute('aria-label'))).toBe(true);
  });
});
