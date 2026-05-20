# stealth-chat

Chat ligero estilo Discord pero con modo sigilo. Tauri + React + TypeScript.

## Características

- Ventana transparente, frameless, redimensionable.
- Personalización en vivo: transparencia, color de letra, color de burbujas (por chat), tamaño.
- **Modo sigilo:**
  - Invisible a screenshots y grabaciones de pantalla (`SetWindowDisplayAffinity`).
  - Siempre encima, oculta del taskbar y Alt+Tab.
  - Click a través (los clicks pasan a la app de atrás).
  - Hotkey global `Ctrl+Shift+H` para ocultar/mostrar.
  - Sin historial de mensajes en disco (modo amnésico).
- Chats 1-a-1 y grupos.
- Envío de imágenes.
- Códigos de invitación (UI lista, conexión por WebRTC pendiente).

## Desarrollo

Requisitos:
- Node 18+
- Rust 1.75+
- Microsoft Visual Studio Build Tools (componente C++)
- Windows 10/11

```powershell
cd stealth-chat
npm install
npm run tauri dev
```

## Build de producción

```powershell
npm run tauri build
```

Genera:
- `src-tauri/target/release/stealth-chat.exe` — binario standalone.
- `src-tauri/target/release/bundle/nsis/stealth-chat_0.1.0_x64-setup.exe` — instalador NSIS (este es el que se distribuye).
- `src-tauri/target/release/bundle/msi/stealth-chat_0.1.0_x64_en-US.msi` — instalador MSI.

Para repartir a amigos: usa el `.exe` setup. Ver `INSTRUCCIONES.md`.

## Estructura

```
stealth-chat/
├── src/                    # React frontend
│   ├── App.tsx             # UI principal
│   ├── styles.css          # CSS vars para live-theming
│   └── main.tsx
├── src-tauri/              # Backend Rust
│   ├── src/lib.rs          # Tauri commands + global shortcut
│   ├── tauri.conf.json     # Config de ventana (transparente, frameless, ...)
│   └── capabilities/       # Permisos
├── INSTRUCCIONES.md        # Guía para usuarios finales
└── README.md               # Este archivo
```

## Por hacer (siguiente fase)

- [ ] WebRTC P2P para mensajería real entre usuarios.
- [ ] Signaling server mínimo (PeerJS o propio).
- [ ] Screen sharing (`getDisplayMedia` + WebRTC).
- [ ] Notificación silenciosa (puntito en pestaña).
- [ ] E2E encryption (vía DTLS de WebRTC).
- [ ] Auto-update con Tauri updater.
