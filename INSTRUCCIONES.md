# stealth-chat — Instrucciones para amigos

Hola, esto es **stealth-chat**, un chat ligero con modo sigilo y screen share. Te lo mando para que probemos.

## Descarga

**👉 https://github.com/Fabz2004/stealth-chat/releases/latest**

Bajas el archivo **`stealth-chat_0.1.0_x64-setup.exe`** (3 MB). Trae todo lo necesario, no instales nada más.

> **Las próximas versiones se actualizan solas.** Solo esta primera vez tienes que descargar manualmente. De ahí en adelante, cuando publique una versión nueva, la app te muestra un popup *"Nueva versión disponible — Actualizar"* y se actualiza sola al darle.

## Instalación (Windows 10/11)

1. Doble click al `.exe`.
2. Si Windows muestra **"Windows protegió tu PC"** (pantalla azul):
   - **"Más información"** → **"Ejecutar de todas formas"**.
   - Es porque la app no está firmada (un certificado vale ~$300/año, no lo tengo). El archivo en sí es seguro.
3. Siguiente → siguiente → instalar.
4. Búscala en el menú inicio como **stealth-chat**.

## Primera vez

1. Te pide tu **nombre** (cómo te van a ver los demás).
2. Te muestra tu **código único** (uno largo tipo `abc123xyz…`). Es **tu identidad** en la red.
3. Tienes dos botones:
   - **Crear chat o grupo** — para hablar con alguien o armar un grupo.
   - **Unirse con código** — si te pasaron un código.

## Cómo chatear con alguien

- Pídele a la otra persona su código y pégalo en **"Crear chat o grupo"** → **Chat 1-a-1**. Le pones un nombre para identificarlo (ej. "Bobby") y le das **Crear**.
- O **mándale tu código** y que él use **"Unirse con código"**.
- El **puntito verde** en la pestaña significa que están conectados. Gris = no conectado.

## Grupos

- **"Crear chat o grupo"** → **Grupo**.
- Le pones nombre al grupo y pegas los códigos de los miembros (separados por coma).
- **Tú serás el host**: los mensajes pasan a través tuyo. Si cierras la app, el grupo se desconecta.

## Atajos

### Globales (funcionan desde cualquier app)

| Atajo | Qué hace |
|---|---|
| `Ctrl + Shift + H` | **Mostrar/ocultar al instante** + **apaga click-a-través** si estaba activo. **Es tu salvavidas.** |

### Dentro de la ventana

| Acción | Qué hace |
|---|---|
| `Enter` | Enviar mensaje |
| `Shift + Enter` | Salto de línea |
| Arrastrar la barra superior | Mover la ventana |
| Click en pestaña | Cambiar de chat |
| **Click medio** en pestaña | Eliminar ese chat |
| Esquinas/bordes | Redimensionar |
| `🖼` | Adjuntar imagen |
| `🖥` | Empezar/parar a compartir tu pantalla |
| `⚙` | Ajustes |
| `–` | **Ocultar** (recupéralo con Ctrl+Shift+H) |
| `×` | Cerrar la app |

## Compartir pantalla

1. Entra a un chat (1-a-1 o grupo).
2. Click en el botón **🖥** abajo, al lado del 🖼.
3. Windows te pregunta qué quieres compartir (toda la pantalla, una ventana específica, una pestaña…). Elige.
4. Los demás verán tu pantalla en su chat. Pueden hacer click al video para expandir.
5. Para parar: click otra vez al botón (que ahora dice **■**), o usa el "Stop sharing" que Windows pone arriba.

## Modo sigilo

Click en ⚙. Vienen activados por defecto:

- **Invisible en capturas** — la ventana NO aparece en screenshots, OBS, Loom ni grabaciones de pantalla. La persona que graba no verá el chat.
- **Siempre encima** — flota sobre el resto.
- **Ocultar de barra de tareas** — no sale en Alt+Tab ni en la barra de Windows. (Si lo apagas, vuelve a aparecer ahí normalmente.)
- **Click a través** (off por defecto) — los clicks atraviesan la ventana hacia la app de atrás. **⚠️ Si lo activas, no podrás clickear nada hasta usar Ctrl+Shift+H.**

## Personalización

En ⚙:
- Transparencia (slider).
- Color de letra y de tinte de fondo.
- Tamaño de letra.
- **Color de mis burbujas y de las burbujas de los demás** — distinto por cada chat. (Si el azul se nota mucho, pónlos gris oscuro o el color que quieras).

## Si no te aparece la ventana o "desaparece"

- **Presiona `Ctrl + Shift + H`**. Esto la muestra de vuelta, sin importar dónde esté (oculta, minimizada, click-a-través activado…). Es el atajo universal de recuperación.
- Si la app está corriendo (íconito en bandeja del sistema o en el menú inicio) y no la ves, el Ctrl+Shift+H la trae.
- Si nada funciona, abre **Administrador de tareas** → cierra **stealth-chat** → vuelve a abrir desde el menú inicio.

## Privacidad

- Los mensajes y el screen share **van directo PC-a-PC**, cifrados con DTLS por WebRTC. No pasan por servidores nuestros.
- PeerJS solo nos ayuda al inicio a encontrarnos en la red; después es directo.
- **Los mensajes no se guardan en disco** — al cerrar la app desaparecen del historial. Solo se guardan los datos de las salas (nombres, códigos, colores).

## Si Windows Defender lo bloquea

- Click derecho al `.exe` → **Propiedades** → marca **"Desbloquear"** → Aplicar.

## Desinstalar

Panel de control → Programas → stealth-chat → Desinstalar.

## ¿No abre? Falta WebView2

Raro en Windows 11 (viene preinstalado), pero por si acaso:
- Descarga: https://developer.microsoft.com/microsoft-edge/webview2/
- "Evergreen Standalone Installer x64" → instalar.
- Volver a abrir stealth-chat.

Cualquier cosa, escríbeme.
