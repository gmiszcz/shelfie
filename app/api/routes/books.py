"""Book endpoints. Thin controllers — all logic lives in services."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.api.deps import CurrentUser, DbConn
from app.schemas.books import Book, BookCreate, BookUpdate
from app.services import books as service
from app.services import ratings

router = APIRouter(prefix="/books", tags=["books"])


@router.get("", response_model=list[Book])
async def list_books(
    user_id: CurrentUser,
    conn: DbConn,
    min_score: float | None = None,
    max_score: float | None = None,
) -> list[Book]:
    return await service.list_library(conn, user_id, min_score=min_score, max_score=max_score)


@router.post("", response_model=Book, status_code=status.HTTP_201_CREATED)
async def add_book(data: BookCreate, user_id: CurrentUser, conn: DbConn) -> Book:
    try:
        book = await service.add_book(conn, user_id, data)
    except service.DuplicateBookError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Book already in library",
        ) from exc
    if book.stars is not None:
        await ratings.recompute(conn, user_id)
        book = await service.get(conn, user_id, book.id) or book
    return book


@router.get("/{book_id}", response_model=Book)
async def get_book(book_id: int, user_id: CurrentUser, conn: DbConn) -> Book:
    book = await service.get(conn, user_id, book_id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return book


@router.patch("/{book_id}", response_model=Book)
async def update_book(book_id: int, data: BookUpdate, user_id: CurrentUser, conn: DbConn) -> Book:
    book = await service.change_book(conn, user_id, book_id, data)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    if "stars" in data.model_fields_set:
        await ratings.recompute(conn, user_id)
        book = await service.get(conn, user_id, book_id) or book
    return book


@router.delete("/{book_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_book(book_id: int, user_id: CurrentUser, conn: DbConn) -> None:
    removed = await service.remove_book(conn, user_id, book_id)
    if not removed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
