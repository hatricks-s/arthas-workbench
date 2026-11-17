@echo off
if not defined WORKBENCH_TEST_PYTHON exit /b 91
if not defined WORKBENCH_FAKE_KUBECTL_EXPECTED exit /b 92
"%WORKBENCH_TEST_PYTHON%" -B "%~dp0fake_kubectl.py" %*
exit /b %errorlevel%
