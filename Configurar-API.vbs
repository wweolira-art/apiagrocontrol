Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("Wscript.Shell")
sh.CurrentDirectory = pasta
sh.Run "cmd /c node painel.mjs", 0, False
