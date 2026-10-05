param([string]$Executable, [string]$TuiExecutable, [string]$ServerExecutable, [string]$Installation, [ValidatePattern('^[A-Za-z0-9._:-]+$')][string]$ReleaseId = 'release:host')
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'ConPTY smoke requires native Windows PowerShell 7' }
if ($Executable) { $Executable = (Resolve-Path -LiteralPath $Executable).Path }
# Native ConPTY, not redirected stdin pretending to be a terminal. Each pipe is serviced separately.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class MareaConPty {
 [StructLayout(LayoutKind.Sequential)] struct Coord { public short X,Y; public Coord(short x,short y){X=x;Y=y;} }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
  public int cb; public string reserved,desktop,title; public int x,y,xSize,ySize,xChars,yChars,fill,flags;
  public short show,reservedSize; public IntPtr reserved2,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] struct Extended { public Startup startup; public IntPtr attributes; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public int pid,tid; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,IntPtr attributes,int size);
 [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(Coord size,IntPtr input,IntPtr output,uint flags,out IntPtr console);
 [DllImport("kernel32.dll")] static extern int ResizePseudoConsole(IntPtr console,Coord size);
 [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Extended startup,out ProcessInfo process);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static void Check(bool ok){if(!ok)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
 public static string Run(string exe,string mode,string arguments) {
  IntPtr ir=IntPtr.Zero,iw=IntPtr.Zero,or=IntPtr.Zero,ow=IntPtr.Zero,pc=IntPtr.Zero,list=IntPtr.Zero;
  ProcessInfo process=new ProcessInfo();
  StreamReader reader=null; FileStream writer=null;
  try {
   Check(CreatePipe(out ir,out iw,IntPtr.Zero,0)); Check(CreatePipe(out or,out ow,IntPtr.Zero,0));
   if(CreatePseudoConsole(new Coord(100,30),ir,ow,0,out pc)!=0)throw new Exception("CreatePseudoConsole failed");
   IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
   list=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(list,1,0,ref size));
   Check(UpdateProcThreadAttribute(list,0,(IntPtr)0x20016,pc,(IntPtr)IntPtr.Size,IntPtr.Zero,IntPtr.Zero));
   Extended startup=new Extended(); startup.startup.cb=Marshal.SizeOf(typeof(Extended)); startup.attributes=list;
   Check(CreateProcess(exe,new StringBuilder("\""+exe+"\""+(mode=="help"?" --lang en --help":(" "+arguments))),IntPtr.Zero,IntPtr.Zero,false,0x80000,IntPtr.Zero,null,ref startup,out process));
   CloseHandle(ir); ir=IntPtr.Zero; CloseHandle(ow); ow=IntPtr.Zero;
   reader=new StreamReader(new FileStream(new SafeFileHandle(or,true),FileAccess.Read)); or=IntPtr.Zero;
   var captured=new StringBuilder();
   writer=new FileStream(new SafeFileHandle(iw,true),FileAccess.Write); iw=IntPtr.Zero;
   var output=Task.Run(()=>{
    char[] buffer=new char[4096]; int count;
    while((count=reader.Read(buffer,0,buffer.Length))>0){lock(captured){captured.Append(buffer,0,count);}}
    lock(captured){return captured.ToString();}
   });
   if(mode!="help") {
    bool ready=false;
    for(int attempt=0;attempt<300;attempt++){
     lock(captured){ready=captured.ToString().Contains(mode=="server"?"Teacher host ready at ":"Marea");}
     if(ready || WaitForSingleObject(process.process,0)==0)break;
     System.Threading.Thread.Sleep(50);
    }
    if(!ready)throw new Exception("OpenTUI did not render in native ConPTY");
    if(mode=="copy-then-quit") {
     byte[] copy=Encoding.UTF8.GetBytes("\u0003");writer.Write(copy,0,copy.Length);writer.Flush();
     if(WaitForSingleObject(process.process,300)==0)throw new Exception("Ctrl+C copy unexpectedly closed the TUI");
    }
    byte[] input=Encoding.UTF8.GetBytes(mode=="server"?"\u0003":"q"); writer.Write(input,0,input.Length);writer.Flush();
   }
   if(ResizePseudoConsole(pc,new Coord(80,24))!=0)throw new Exception("ResizePseudoConsole failed");
   if(WaitForSingleObject(process.process,15000)!=0){TerminateProcess(process.process,1);throw new Exception("ConPTY command timed out");}
   uint code; Check(GetExitCodeProcess(process.process,out code));
   ClosePseudoConsole(pc); pc=IntPtr.Zero; writer.Dispose();
   if(!output.Wait(5000))throw new Exception("ConPTY output did not drain");
   reader.Dispose();
   uint expected=0u;
   if(code!=expected)throw new Exception("ConPTY exit status failed: "+code);
   if(mode=="help" && !output.Result.Contains("Usage: marea"))throw new Exception("ConPTY CLI output failed");
   if(mode!="help" && mode!="server" && !output.Result.Contains("[?1049l"))throw new Exception("OpenTUI did not restore the alternate screen");
   if(mode=="server" && !output.Result.Contains("Teacher host stopped."))throw new Exception("Server did not drain on Ctrl+C");
   return output.Result;
  } finally {
   if(process.process!=IntPtr.Zero && WaitForSingleObject(process.process,0)!=0){TerminateProcess(process.process,1);WaitForSingleObject(process.process,5000);}
   if(writer!=null)writer.Dispose();
   if(process.thread!=IntPtr.Zero)CloseHandle(process.thread); if(process.process!=IntPtr.Zero)CloseHandle(process.process);
   if(pc!=IntPtr.Zero)ClosePseudoConsole(pc);
   if(reader!=null)reader.Dispose();
   foreach(var handle in new[]{ir,iw,or,ow})if(handle!=IntPtr.Zero)CloseHandle(handle);
   if(list!=IntPtr.Zero){DeleteProcThreadAttributeList(list);Marshal.FreeHGlobal(list);}
  }
 }
}
'@
if ($Executable) { [MareaConPty]::Run($Executable, "help", "") }
if ($TuiExecutable) {
  $TuiExecutable = (Resolve-Path -LiteralPath $TuiExecutable).Path
  [MareaConPty]::Run($TuiExecutable, "quit", "")
  [MareaConPty]::Run($TuiExecutable, "copy-then-quit", "")
}
Write-Output 'ConPTY native CLI/resize and requested OpenTUI quit/Ctrl+C-copy/restoration checks passed.'

if ($ServerExecutable) {
  $ServerExecutable = (Resolve-Path -LiteralPath $ServerExecutable).Path
  $Installation = (Resolve-Path -LiteralPath $Installation).Path
  [MareaConPty]::Run($ServerExecutable, "server", "--installation `"$Installation`" --release $ReleaseId")
}
