@echo off
echo Recortando la imagen a un cuadrado perfecto (1:1)...
powershell -Command "Add-Type -AssemblyName System.Drawing; $path = 'icon.png'; $img = [System.Drawing.Image]::FromFile($path); $size = [math]::Min($img.Width, $img.Height); $bmp = New-Object System.Drawing.Bitmap $size, $size; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.DrawImage($img, (New-Object System.Drawing.Rectangle 0, 0, $size, $size), (New-Object System.Drawing.Rectangle (($img.Width - $size) / 2), (($img.Height - $size) / 2), $size, $size), [System.Drawing.GraphicsUnit]::Pixel); $img.Dispose(); $bmp.Save('icon-square.png', [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()"

echo Generando iconos con Tauri...
call pnpm tauri icon icon-square.png

echo Copiando icono a la carpeta public...
copy icon-square.png public\icon.png

echo ¡Todo listo!
