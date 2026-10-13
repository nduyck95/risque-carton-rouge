@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Outil carton rouge - serveur
echo ============================================================
echo    OUTIL CARTON ROUGE - serveur local
echo.
echo    * Laisse cette fenetre OUVERTE pendant que tu utilises l'outil.
echo    * Pour tout arreter : ferme simplement cette fenetre.
echo ============================================================
echo.

REM Verifie que Node.js est bien installe
where node >nul 2>nul
if errorlevel 1 (
  echo ERREUR : Node.js n'a pas ete trouve sur cet ordinateur.
  echo Installe-le depuis https://nodejs.org puis relance ce fichier.
  echo.
  pause
  exit /b
)

echo Le navigateur va s'ouvrir tout seul dans quelques secondes...
echo.
REM Ouvre la page dans le navigateur apres un court delai (le temps que le serveur demarre)
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 3; Start-Process 'http://localhost:8123/matchs'"

REM Demarre le serveur (c'est lui qui fait tout le travail)
node serveur.js

echo.
echo ------------------------------------------------------------
echo  Le serveur s'est arrete.
echo  (S'il y a une erreur ci-dessus, fais une capture d'ecran.)
echo ------------------------------------------------------------
pause
