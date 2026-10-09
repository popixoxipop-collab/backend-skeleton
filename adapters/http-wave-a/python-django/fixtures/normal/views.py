from django.http import JsonResponse


def health(request):
    return JsonResponse({"ok": True})


def item(request, pk):
    return JsonResponse({"id": pk})


def legacy(request, slug):
    return JsonResponse({"slug": slug})
