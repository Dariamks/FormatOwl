from pathlib import Path
from PIL import Image, ImageDraw
import pillow_heif
import pikepdf
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
import io

folder=Path('.data/fixtures')
folder.mkdir(parents=True,exist_ok=True)
im=Image.new('RGB',(1800,1200))
im.putdata([((x*17+y*3)%256,(x*2+y*11)%256,(x+y*7)%256) for y in range(1200) for x in range(1800)])
im.save(folder/'photo.jpg',quality=99)
im.save(folder/'photo.jpeg',quality=98)
im.save(folder/'photo.webp',quality=100)
rotated=im.resize((640,480));exif=Image.Exif();exif[274]=6;rotated.save(folder/'oriented.jpg',exif=exif)
transparent=Image.new('RGBA',(600,400),(0,0,0,0));draw=ImageDraw.Draw(transparent);draw.rounded_rectangle((80,60,520,340),30,fill=(42,63,210,180));transparent.save(folder/'transparent.png')
frames=[]
for index in range(4):
 frame=Image.new('RGBA',(240,160),(0,0,0,0));ImageDraw.Draw(frame).rectangle((20+index*30,30,80+index*30,90),fill=(35,80,200,255));frames.append(frame)
frames[0].save(folder/'animated.gif',save_all=True,append_images=frames[1:],duration=[100,200,150,250],loop=2,disposal=2)
frames[0].save(folder/'animated.webp',save_all=True,append_images=frames[1:],duration=[100,200,150,250],loop=2,lossless=True)
pillow_heif.from_pillow(im.resize((900,600))).save(folder/'photo.heic',quality=95)
small=im.resize((80,60));small.save(folder/'already.jpg',quality=5,optimize=True)
for ext in ['png','pdf','mp3','heic']:(folder/f'broken.{ext}').write_bytes(b'not a file format')
output=canvas.Canvas(str(folder/'document.pdf'),pagesize=(600,800),pageCompression=0)
output.setTitle('FormatOwl test document');output.bookmarkPage('first');output.addOutlineEntry('First page','first')
output.drawString(50,750,'FormatOwl searchable text - Invoice 12345')
output.linkURL('https://example.com',(50,710,260,735),relative=0)
output.drawString(50,715,'Reference link')
output.acroForm.textfield(name='customer',value='Sample customer',x=50,y=660,width=180,height=22)
for i in range(5):
 output.line(50,600-i*25,550,600-i*25);output.drawString(60,585-i*25,f'Row {i+1}    Amount {i*25}.00')
output.drawImage(ImageReader(im),50,100,width=500,height=330)
output.showPage();output.drawString(50,750,'Second page with transparent image');output.drawImage(ImageReader(transparent),50,350,width=500,height=330,mask='auto');output.save()
scan=canvas.Canvas(str(folder/'scan.pdf'),pagesize=(600,800));scan.drawImage(ImageReader(im),0,0,width=600,height=800);scan.save()
with pikepdf.open(folder/'document.pdf') as pdf:pdf.save(folder/'encrypted.pdf',encryption=pikepdf.Encryption(owner='owner',user='password'))
with pikepdf.open(folder/'document.pdf') as pdf:
 sig=pdf.make_indirect(pikepdf.Dictionary(FT=pikepdf.Name.Sig,T='Signature',V=pikepdf.Dictionary(Type=pikepdf.Name.Sig)))
 pdf.Root.AcroForm.Fields.append(sig);pdf.save(folder/'signed.pdf')
print('Image, HEIC, PDF and invalid fixtures ready')

import subprocess
for extension,codec in [('wav','pcm_s16le'),('mp3','libmp3lame'),('m4a','aac'),('aac','aac'),('flac','flac'),('ogg','libopus')]:
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=5','-ac','2','-c:a',codec,str(folder/f'audio.{extension}')],check=True)
print('Audio fixtures ready')
