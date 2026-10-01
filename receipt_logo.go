package main

import (
	"bytes"
	_ "embed"
	"image"
	"image/png"
)

// The receipt header uses the existing ui/src/assets/npl-logo.png badge,
// arranged beside the NPL wordmark (Arial Bold). It is bundled so printing
// never needs the network, an external image URL, or an installed font.
//
//go:embed ui/src/assets/npl-receipt-logo.png
var receiptLogoPNG []byte

var receiptLogoImage = func() image.Image {
	logo, err := png.Decode(bytes.NewReader(receiptLogoPNG))
	if err != nil {
		panic("invalid bundled NPL receipt logo: " + err.Error())
	}
	return logo
}()

// receiptRaster has one bit per pixel: 1 is black, starting at the high bit
// of each byte. Rows are byte-aligned as required by ESC/POS GS v 0.
type receiptRaster struct {
	Width  int
	Height int
	Bits   []byte
}

func (r receiptRaster) escpos() []byte {
	rowBytes := (r.Width + 7) / 8
	data := []byte{0x1d, 'v', '0', 0, byte(rowBytes), byte(rowBytes >> 8), byte(r.Height), byte(r.Height >> 8)}
	return append(data, r.Bits...)
}

func receiptLogoRaster(width int) receiptRaster {
	bounds := receiptLogoImage.Bounds()
	height := width * bounds.Dy() / bounds.Dx()
	rowBytes := (width + 7) / 8
	raster := receiptRaster{Width: width, Height: height, Bits: make([]byte, rowBytes*height)}
	// An ordered pattern preserves the colour badge's shading on a black-only
	// thermal head. Box sampling keeps the small ring lettering readable.
	bayer := [4][4]int{{0, 8, 2, 10}, {12, 4, 14, 6}, {3, 11, 1, 9}, {15, 7, 13, 5}}
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			left, right := x*bounds.Dx()/width, (x+1)*bounds.Dx()/width
			top, bottom := y*bounds.Dy()/height, (y+1)*bounds.Dy()/height
			var luminance, count uint64
			for sy := top; sy < max(top+1, bottom); sy++ {
				for sx := left; sx < max(left+1, right); sx++ {
					r, g, b, alpha := receiptLogoImage.At(bounds.Min.X+sx, bounds.Min.Y+sy).RGBA()
					// RGBA is premultiplied: composite transparency onto white.
					white := uint64(0xffff - alpha)
					luminance += (299*uint64(r)+587*uint64(g)+114*uint64(b))/1000 + white
					count++
				}
			}
			threshold := uint64((bayer[y%4][x%4]*2 + 1) * 65536 / 32)
			if luminance/count < threshold {
				raster.Bits[y*rowBytes+x/8] |= 1 << (7 - x%8)
			}
		}
	}
	return raster
}

// dibPixels converts the shared monochrome image to top-down BGR with
// DWORD-aligned rows, which StretchDIBits accepts on printer and memory DCs.
func (r receiptRaster) dibPixels() []byte {
	stride := (r.Width*3 + 3) &^ 3
	bitmap := bytes.Repeat([]byte{0xff}, stride*r.Height)
	rowBytes := (r.Width + 7) / 8
	for y := 0; y < r.Height; y++ {
		for x := 0; x < r.Width; x++ {
			if r.Bits[y*rowBytes+x/8]&(1<<(7-x%8)) != 0 {
				index := y*stride + x*3
				bitmap[index], bitmap[index+1], bitmap[index+2] = 0, 0, 0
			}
		}
	}
	return bitmap
}
