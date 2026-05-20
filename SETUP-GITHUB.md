# Setup de GitHub + auto-update (solo Bobby)

Esta guía es para **ti**, Bobby, para configurar la primera vez el repo de GitHub y el sistema de actualizaciones automáticas. Tus amigos no leen esto.

---

## Paso 1: Crear el repo en GitHub

1. Ve a https://github.com/new
2. **Repository name**: `stealth-chat`
3. **Public** o **Private** — da igual para el updater (las releases se pueden marcar públicas aunque el repo sea privado, pero para simplicidad usa Public).
4. **NO** marques "Add a README" (ya tenemos).
5. Click **Create repository**.

Anota tu **usuario de GitHub** (lo que aparece en la URL del repo).

---

## Paso 2: Reemplazar el placeholder en `tauri.conf.json`

Abre `src-tauri/tauri.conf.json` y busca esta línea:

```json
"endpoints": [
  "https://github.com/REEMPLAZA-USUARIO/stealth-chat/releases/latest/download/latest.json"
]
```

Cambia `REEMPLAZA-USUARIO` por tu usuario de GitHub. Por ejemplo si eres `bobby123`:

```json
"https://github.com/bobby123/stealth-chat/releases/latest/download/latest.json"
```

Guarda.

---

## Paso 3: Inicializar git y subir el código

Desde `stealth-chat/`:

```powershell
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/stealth-chat.git
git push -u origin main
```

Si nunca usaste git en esta máquina, te va a pedir login con GitHub. Usa GitHub CLI (`gh auth login`) o configura un Personal Access Token.

> **IMPORTANTE:** El archivo `src-tauri/target/`, `node_modules/`, y **las claves privadas** (`~/.tauri/stealth-chat.key`) están en `.gitignore` y NO se suben. La clave privada se queda solo en tu PC.

---

## Paso 4: Tu primera release con auto-update

### Construir + firmar

Desde `stealth-chat/`:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$HOME/.tauri/stealth-chat.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npm run tauri build
```

Esto genera:
- `src-tauri/target/release/bundle/nsis/stealth-chat_0.1.0_x64-setup.exe`
- `src-tauri/target/release/bundle/nsis/stealth-chat_0.1.0_x64-setup.exe.sig`  ← la firma
- `src-tauri/target/release/bundle/nsis/latest.json`  ← manifest del updater

### Subir a GitHub Release

1. Ve a `https://github.com/TU-USUARIO/stealth-chat/releases/new`
2. **Tag**: `v0.1.0`
3. **Title**: `v0.1.0 — Primera versión`
4. **Description**: lo que cambió.
5. **Adjuntar archivos** (drag-and-drop):
   - `stealth-chat_0.1.0_x64-setup.exe`
   - `stealth-chat_0.1.0_x64-setup.exe.sig`
   - `latest.json`
6. Click **Publish release**.

### Comparte el primer download

A tus amigos les pasas la URL:
```
https://github.com/TU-USUARIO/stealth-chat/releases/latest
```
Que descarguen `stealth-chat_0.1.0_x64-setup.exe`. Lo instalan **una sola vez**. De ahí en adelante, las actualizaciones llegan solas.

---

## Paso 5: Publicar una actualización nueva (versión 0.1.1, 0.2.0, etc.)

Cada vez que quieras subir cambios:

### a) Aumentar la versión en 3 archivos

- `package.json` → `"version": "0.1.1"`
- `src-tauri/tauri.conf.json` → `"version": "0.1.1"`
- `src-tauri/Cargo.toml` → `version = "0.1.1"`

### b) Build con la clave de firma

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$HOME/.tauri/stealth-chat.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npm run tauri build
```

### c) Editar `latest.json` antes de subir

El `latest.json` que genera Tauri tiene **una ruta relativa**. Edítalo para que apunte al asset de tu GitHub Release. Debería verse así:

```json
{
  "version": "0.1.1",
  "notes": "Bugfixes",
  "pub_date": "2026-05-25T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "...(lo que ya tiene)...",
      "url": "https://github.com/TU-USUARIO/stealth-chat/releases/download/v0.1.1/stealth-chat_0.1.1_x64-setup.exe"
    }
  }
}
```

> Lo único que cambias manualmente es el `url`. El `signature` ya viene generado por la build.

### d) Crear el Release

1. `https://github.com/TU-USUARIO/stealth-chat/releases/new`
2. **Tag**: `v0.1.1` (con la `v` adelante).
3. Adjunta los 3 archivos (`exe`, `exe.sig`, `latest.json`).
4. **Publish release**.

### e) Listo

Tus amigos, la próxima vez que abran la app, verán el popup **"Nueva versión 0.1.1 disponible — Actualizar"**. Cuando le den click, descarga, verifica firma, instala, y reinicia. **Ellos no hacen nada más.**

---

## Resumen de comandos para release rápido

Guarda esto como `publish.ps1` en la raíz de `stealth-chat/`:

```powershell
param([Parameter(Mandatory)][string]$Version)

# Bump versions
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$pkg.version = $Version
$pkg | ConvertTo-Json -Depth 10 | Set-Content package.json

$conf = Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json
$conf.version = $Version
$conf | ConvertTo-Json -Depth 10 | Set-Content src-tauri/tauri.conf.json

(Get-Content src-tauri/Cargo.toml) -replace '^version = ".*"', "version = `"$Version`"" | Set-Content src-tauri/Cargo.toml

# Build & sign
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$HOME/.tauri/stealth-chat.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npm run tauri build

# Locate outputs
$exe = "src-tauri/target/release/bundle/nsis/stealth-chat_${Version}_x64-setup.exe"
$sig = "$exe.sig"
$json = "src-tauri/target/release/bundle/nsis/latest.json"

Write-Host "Artifacts ready:"
Write-Host "  $exe"
Write-Host "  $sig"
Write-Host "  $json"
Write-Host "Now edit $json's url field to point to:"
Write-Host "  https://github.com/USER/stealth-chat/releases/download/v$Version/stealth-chat_${Version}_x64-setup.exe"
Write-Host "Then create a GitHub Release tagged v$Version with these 3 files."
```

Uso: `.\publish.ps1 0.1.1`

---

## Cosas importantes

1. **Nunca** subas tu **clave privada** (`~/.tauri/stealth-chat.key`) a GitHub. Si la pierdes, no podrás publicar más actualizaciones para esta app.
2. La **clave pública** ya está incrustada en el binario y en `tauri.conf.json`. Esa sí va al repo.
3. Si quieres rotar las claves después, hay que volver a generar y reinstalar la app en TODOS los clientes. Mejor no perder la privada.
4. El tag de Git debe ser `v0.1.1` (con `v`), no `0.1.1`. La URL de "latest" en GitHub depende de los tags.
5. Si tus amigos no reciben el update, verifica que el `latest.json` esté accesible en:
   `https://github.com/TU-USUARIO/stealth-chat/releases/latest/download/latest.json`

---

## Si algo falla

- **El popup no aparece**: revisa la consola del DevTools (F12 si lo habilitas) por errores `[updater]`.
- **"Signature verification failed"**: el `latest.json` y el `.exe` no coinciden — verifica que ambos sean de la misma build.
- **"Network error"**: la URL en `endpoints` está mal o el repo está privado y el `latest.json` no es accesible públicamente.
