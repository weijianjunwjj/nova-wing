Option Explicit

Dim shell, fileSystem, repoDirectory, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

repoDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = repoDirectory
command = "cmd.exe /d /s /c ""npm run guardian:launchpad"""

shell.Run command, 0, False
