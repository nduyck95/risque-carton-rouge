' ============================================================================
'  lancer-envoi-winamax.vbs - lance envoi-winamax.js SANS ouvrir de fenetre.
'  Utilise par la tache planifiee Windows "Risque carton rouge - envoi Winamax"
'  (toutes les 30 min, quand la session Windows est ouverte).
'  Le compte-rendu de chaque passage est ajoute a journal-envoi-winamax.txt,
'  dans le meme dossier que ce fichier (le journal n'est pas envoye sur GitHub).
' ============================================================================
Dim fso, shell, dossier, journal
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
dossier = fso.GetParentFolderName(WScript.ScriptFullName)
journal = dossier & "\journal-envoi-winamax.txt"

' Si le journal depasse 200 Ko, on repart d'un journal vide (l'ancien est garde en .ancien.txt)
If fso.FileExists(journal) Then
  If fso.GetFile(journal).Size > 200000 Then
    If fso.FileExists(dossier & "\journal-envoi-winamax.ancien.txt") Then fso.DeleteFile dossier & "\journal-envoi-winamax.ancien.txt"
    fso.MoveFile journal, dossier & "\journal-envoi-winamax.ancien.txt"
  End If
End If

shell.CurrentDirectory = dossier
' 0 = fenetre cachee ; True = attendre la fin
shell.Run "cmd /c (echo ===== %date% %time% & node envoi-winamax.js --envoyer) >> """ & journal & """ 2>&1", 0, True
