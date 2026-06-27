-- cmux-mobile double-click launcher.
-- Compiled into an .app by scripts/build-app.sh, which substitutes the absolute
-- node path and bin path (__NODE__ / __BIN__) for this machine. The .app runs
-- the background server with NO Terminal window; double-click toggles it.

property nodeBin : "__NODE__"
property binPath : "__BIN__"

on cmuxRun(subcommand)
	return do shell script quoted form of nodeBin & " " & quoted form of binPath & " " & subcommand
end cmuxRun

on cmuxUrl()
	try
		set js to "try{const a=require(require('os').homedir()+'/.local/state/cmux-mobile/access.json');process.stdout.write((a.urls&&a.urls[0])||a.local||'')}catch(e){}"
		return do shell script quoted form of nodeBin & " -e " & quoted form of js
	on error
		return ""
	end try
end cmuxUrl

on isRunning()
	try
		return (my cmuxRun("status")) starts with "Running"
	on error
		return false
	end try
end isRunning

on run
	try
		if my isRunning() then
			set u to my cmuxUrl()
			set act to button returned of (display dialog "cmux-mobile is running." & return & return & u buttons {"Stop", "Copy URL", "OK"} default button "OK" with title "cmux-mobile")
			if act is "Stop" then
				my cmuxRun("down")
				display notification "Stopped." with title "cmux-mobile"
			else if act is "Copy URL" then
				if u is not "" then set the clipboard to u
				display notification "Phone URL copied to clipboard." with title "cmux-mobile"
			end if
		else
			my cmuxRun("up")
			set u to my cmuxUrl()
			if u is not "" then set the clipboard to u
			display notification u with title "cmux-mobile started" subtitle "Phone URL copied to clipboard"
		end if
	on error errMsg
		display dialog "cmux-mobile failed to launch:" & return & return & errMsg buttons {"OK"} default button "OK" with icon caution with title "cmux-mobile"
	end try
end run
