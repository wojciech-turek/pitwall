@echo off
rem Stub Claude CLI for tests on Windows: runs claude.mjs (the Node stub) with every argument.
node "%~dp0claude.mjs" %*
exit /b %errorlevel%
