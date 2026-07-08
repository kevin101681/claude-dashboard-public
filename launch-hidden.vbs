' Launches the Claude Dashboard server with no visible window.
' Used by the "Claude Dashboard" logon task (see README).
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
' Run from this script's own folder, wherever the repo lives.
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
' stdout/stderr go to server.log so crashes are diagnosable (the hidden window otherwise discards them)
sh.Run "cmd /s /c """"C:\Program Files\nodejs\node.exe"" server.js >> server.log 2>&1""", 0, False
