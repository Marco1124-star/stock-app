import React from "react";
import { NavLink } from "react-router-dom";
import { FiHome, FiSearch, FiUsers } from "react-icons/fi";
import { RiHome5Fill } from "react-icons/ri";

// Hidden on desktop by Mobile.css; ordinary links preserve browser navigation.
export default function MobileNavigation({ darkMode, onNavigate, username, accountOpen = false, onAccountToggle }) {
  return (
    <nav className={`mobile-navigation ${darkMode ? "dark" : "light"}`} aria-label="Navigazione rapida">
      {[
        { to: "/", label: "Home", Icon: FiHome },
        { to: "/search", label: "Cerca", Icon: FiSearch },
        { to: "/social", label: "Portafogli", Icon: FiUsers },
      ].map(({ to, label, Icon }) => (
        <NavLink key={to} to={to} end onClick={onNavigate} aria-label={label} title={label}
          className={({ isActive }) => `mobile-navigation-link${isActive ? " active" : ""}`}>
          {({ isActive }) => <>
            {to === "/" && isActive ? <RiHome5Fill aria-hidden="true" /> : <Icon aria-hidden="true" />}
            <span className="mobile-navigation-label">{label}</span>
          </>}
        </NavLink>
      ))}
      <button type="button" className={`mobile-navigation-link mobile-navigation-account${accountOpen ? " active" : ""}`}
        aria-label="Account" title="Account" aria-haspopup="menu" aria-expanded={accountOpen}
        aria-controls="account-menu-panel" onClick={onAccountToggle}>
        <span className="mobile-navigation-avatar" aria-hidden="true">{(username || "U").slice(0, 1).toUpperCase()}</span>
        <span className="mobile-navigation-label">Account</span>
      </button>
    </nav>
  );
}
