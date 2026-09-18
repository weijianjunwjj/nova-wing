' Windows-only compatibility launcher. macOS/Linux: npm run guardian:launchpad
Option Explicit

Dim shell, fileSystem, repoDirectory, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

repoDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = repoDirectory
command = "wscript.exe //B """ & fileSystem.BuildPath(repoDirectory, "NovaWing.windows.vbs") & """

shell.Run command, 0, False
