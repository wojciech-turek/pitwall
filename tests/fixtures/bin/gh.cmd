@echo off
rem Stub gh CLI for tests on Windows: runs gh.mjs (the Node stub) with every argument.
node "%~dp0gh.mjs" %*
exit /b %errorlevel%
