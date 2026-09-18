"""Isolated Docling process. Only local files/models; OCR is supplied by the metered worker."""
import json, os, sys
from pathlib import Path

os.environ['HF_HUB_OFFLINE']='1'
os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
os.environ.setdefault('OMP_NUM_THREADS','4')


def convert(payload):
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, OcrMode, OcrAutoOptions, TableStructureOptions, TableFormerMode, LayoutObjectDetectionOptions
    from docling.datamodel.accelerator_options import AcceleratorOptions, AcceleratorDevice
    from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline
    from docling.models.base_ocr_model import BaseOcrModel
    from docling_core.types.doc import BoundingBox, CoordOrigin
    from docling_core.types.doc.page import TextCell, BoundingRectangle

    class SavedOcr(BaseOcrModel):
        options_accelerator = AcceleratorOptions(device=AcceleratorDevice.CPU,num_threads=4)
        @classmethod
        def get_options_type(cls):return OcrAutoOptions
        def __call__(self, conv_res, page_batch):
            for page in page_batch:
                cells=[]
                for block in payload['data']['blocks']:
                    if block['page']!=page.page_no-1 or not block.get('raster') or not block.get('box'):continue
                    scale=payload['data']['pages'][page.page_no-1].get('scale',1);b=block.get('originalBox') or block['box']
                    rect=BoundingBox(l=b['x']/scale,t=b['y']/scale,r=(b['x']+b['width'])/scale,b=(b['y']+b['height'])/scale,coord_origin=CoordOrigin.TOPLEFT)
                    cells.append(TextCell(index=len(cells),text=block['sourceText'],orig=block['sourceText'],from_ocr=True,confidence=.75 if 'OCR_REVIEW' in block.get('review',[]) else 1,rect=BoundingRectangle.from_bounding_box(rect)))
                if cells:
                    # Use upstream full-page replacement for OCR-only pages. The
                    # model is shared by pipeline threads: never mutate its options.
                    mode = OcrMode.FULL_PAGE if payload['data']['pages'][page.page_no-1].get('textSource') == 'ocr' else OcrMode.DEFAULT
                    processor = SavedOcr(enabled=True, artifacts_path=None, options=OcrAutoOptions(mode=mode), accelerator_options=self.options_accelerator)
                    processor.post_process_cells(cells,page,conv_res)
                yield page

    class SavedOcrPipeline(StandardPdfPipeline):
        def _make_ocr_model(self,art_path):
            return SavedOcr(enabled=True,artifacts_path=art_path,options=OcrAutoOptions(),accelerator_options=self.pipeline_options.accelerator_options)

    root=Path(__file__).resolve().parents[3]
    models=Path(os.environ.get('DOCLING_ARTIFACTS_PATH',root/'.data/docling-models'))
    for artifact in ['docling-project--docling-layout-heron/model.safetensors','docling-project--docling-models/model_artifacts/tableformer/accurate/tableformer_accurate.safetensors']:
        if not (models/artifact).exists():raise ValueError('DOCUMENT_ENGINE_UNAVAILABLE')
    layout=LayoutObjectDetectionOptions.from_preset('layout_heron_default')
    layout.model_spec.revision='8f39ad3c0b4c58e9c2d2c84a38465abf757272d8'
    options=PdfPipelineOptions(artifacts_path=models,do_ocr=True,do_table_structure=True,
        layout_options=layout,table_structure_options=TableStructureOptions(mode=TableFormerMode.ACCURATE),
        do_picture_classification=False,do_picture_description=False,do_formula_enrichment=False,
        enable_remote_services=False,generate_parsed_pages=True,
        accelerator_options=AcceleratorOptions(device=AcceleratorDevice.CPU,num_threads=4))
    converter=DocumentConverter(format_options={InputFormat.PDF:PdfFormatOption(pipeline_cls=SavedOcrPipeline,pipeline_options=options)})
    result=converter.convert(Path(payload['source']),max_num_pages=100)
    if str(result.status.value)!='success':raise ValueError('DOCUMENT_STRUCTURE_FAILED')
    doc=result.document;items=[]
    def box_of(box,page):
        b=box.to_top_left_origin(page_height=doc.pages[page].size.height)
        scale=payload['data']['pages'][page-1].get('scale',1)
        target=payload['data']['pages'][page-1];x=min(target['width']-1,max(0,b.l*scale));y=min(target['height']-1,max(0,b.t*scale))
        return {'x':x,'y':y,'width':min(target['width']-x,max(1,b.r*scale-x)),'height':min(target['height']-y,max(1,b.b*scale-y)),'angle':0}
    for item,level in doc.iterate_items():
        if not item.prov:continue
        prov=item.prov[0];page=prov.page_no;label=item.label.value
        base={'ref':item.self_ref,'label':label,'page':page-1,'box':box_of(prov.bbox,page),'text':getattr(item,'text',''),'marker':getattr(item,'marker',None)}
        if label=='table':
            base['cells']=[{'text':cell.text,'box':box_of(cell.bbox,page) if cell.bbox else base['box'],
                'row':cell.start_row_offset_idx,'column':cell.start_col_offset_idx,'rowSpan':cell.row_span,'columnSpan':cell.col_span,
                'header':cell.column_header,'rows':item.data.num_rows,'columns':item.data.num_cols} for cell in item.data.table_cells]
        items.append(base)
    return {'items':items,'engine':'docling-2.127.0-heron-tableformer-accurate'}


if __name__=='__main__':
    payload=json.loads(Path(sys.argv[1]).read_text())
    result=convert(payload)
    Path(payload['result']).write_text(json.dumps(result,ensure_ascii=False))
