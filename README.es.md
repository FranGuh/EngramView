<p align="center">
  <img src="./icon.png" width="128" height="128" alt="EngramView Logo" />
</p>

<h1 align="center">EngramView</h1>

<p align="center">
  <strong>Navegador de escritorio de solo lectura para la base de datos de memorias locales de Engram.</strong>
</p>

<p align="center">
  <a href="README.md">English</a> • <a href="README.es.md">Español</a>
</p>

---

EngramView es una aplicación de escritorio diseñada para inspeccionar la base de datos de memorias locales de [Engram](https://github.com/Gentleman-Programming) por proyecto. Fue construida con un solo propósito: facilitar la consulta visual del historial de codificación con IA sin exponer comandos de modificación o escritura.

La aplicación es intencionadamente de **solo lectura**. Permite listar proyectos, buscar memorias, revisar metadatos y abrir el contenido completo de cada observación, pero **no permite editar, borrar, importar, exportar ni migrar** datos de Engram.

---

## 🚀 Inicio Rápido

```bash
# Instalar dependencias
pnpm install

# Ejecutar en modo desarrollo
pnpm tauri dev
```

---

## 📁 Ubicación Personalizada de las Memorias Engram (`ENGRAM_DATA_DIR`)

Por defecto, EngramView busca la base de datos de Engram en:
- **Windows:** `%USERPROFILE%\.engram\engram.db` *(ej. `C:\Users\tu_usuario\.engram\engram.db`)*
- **macOS / Linux:** `~/.engram/engram.db`

### ¿Qué hacer si tus memorias de Engram están en otra ruta?
Si tu directorio `.engram` se encuentra en otro disco, en una carpeta personalizada o en una carpeta de sincronización, debes configurar la variable de entorno `ENGRAM_DATA_DIR` apuntando a la **carpeta** que contiene el archivo `engram.db`.

#### 1. Windows PowerShell (Desarrollo)
```powershell
$env:ENGRAM_DATA_DIR="D:\RutaPersonalizada\.engram"
pnpm tauri dev
```

#### 2. Windows CMD (Desarrollo)
```cmd
set ENGRAM_DATA_DIR=D:\RutaPersonalizada\.engram
pnpm tauri dev
```

#### 3. macOS / Linux (Bash o Zsh)
```bash
export ENGRAM_DATA_DIR="/ruta/personalizada/.engram"
pnpm tauri dev
```

#### 4. Configuración Permanente en Windows (Variables de Entorno del Sistema)
Si estás ejecutando la aplicación compilada (`engramview.exe`):
1. Presiona `Win + R`, escribe `sysdm.cpl` y presiona **Enter**.
2. Ve a la pestaña **Opciones avanzadas** y haz clic en **Variables de entorno**.
3. En **Variables de usuario**, haz clic en **Nueva...**.
4. Nombre de la variable: `ENGRAM_DATA_DIR`
5. Valor de la variable: `D:\RutaPersonalizada\.engram` *(ruta a la carpeta contenedora de `engram.db`)*
6. Haz clic en **Aceptar** y ejecuta `engramview.exe`.

O mediante PowerShell (ámbito de usuario):
```powershell
[System.Environment]::SetEnvironmentVariable("ENGRAM_DATA_DIR", "D:\RutaPersonalizada\.engram", "User")
```

---

## ✨ Funcionalidades

| Área | Comportamiento |
| --- | --- |
| **Proyectos** | Lista los proyectos de Engram con conteo de observaciones, sesiones, prompts y fechas de actividad. |
| **Memorias** | Muestra tarjetas paginadas de memorias con ID, título, tipo, alcance, vista previa y marca de tiempo. |
| **Búsqueda** | Utiliza el índice FTS de Engram para buscar memorias dentro del proyecto seleccionado. |
| **Ordenación** | Permite alternar la lista entre las memorias más recientes o las más antiguas. |
| **Detalle** | Abre el contenido completo de la memoria con su ID de sincronización, clave de tema y marcas de tiempo. |
| **Estado de Seguridad** | Indica si la aplicación está conectada correctamente a la base de datos local esperada. |

---

## 🔒 Modelo de Seguridad

EngramView está diseñado estrictamente como un visualizador:

- Abre SQLite utilizando banderas `SQLITE_OPEN_READ_ONLY`.
- Activa `PRAGMA query_only` para una protección adicional a nivel de motor SQLite.
- Expone exclusivamente comandos orientados a lectura en Rust/Tauri (`project list`, `memory list`, `memory detail`, `database info`).
- **No** expone comandos de actualización, eliminación, sincronización, importación, exportación o consola.
- **No** ejecuta un servidor web local.

---

## 🛠️ Tecnologías Utilizadas

| Capa | Tecnología |
| --- | --- |
| **Shell de Escritorio** | Tauri 2 |
| **Frontend** | React 19 + TypeScript + Vite |
| **Estilos** | Tailwind CSS 4 + Radix Primitives |
| **Backend** | Rust |
| **Acceso a Base de Datos** | `rusqlite` con SQLite embebido (Solo lectura) |

---

## 💻 Desarrollo y Compilación

```bash
# Compilar frontend
pnpm build

# Ejecutar chequeos de Rust
cd src-tauri
cargo check
cargo test

# Generar ejecutable de producción
pnpm tauri build
```

---

## 📜 Licencia

Este proyecto está bajo la Licencia [MIT](LICENSE).
